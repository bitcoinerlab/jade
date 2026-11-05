package com.bitcoinerlab.jadereactnative

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Base64
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

private const val MODULE_NAME = "BitcoinerlabJade"
private const val DEFAULT_CONNECT_TIMEOUT_MS = 30_000
private const val IO_TIMEOUT_MS = 120_000

private val JADE_USB_IDS = setOf(
  Pair(0x10c4, 0xea60),
  Pair(0x1a86, 0x55d4),
  Pair(0x0403, 0x6001),
  Pair(0x1a86, 0x7523),
  Pair(0x303a, 0x4001),
  Pair(0x303a, 0x1001)
)

class JadeNativeException(message: String, cause: Throwable? = null) :
  CodedException(message, cause)

private data class JadeUsbSession(
  val id: String,
  val connection: UsbDeviceConnection,
  val port: UsbSerialPort,
  val ioManager: SerialInputOutputManager
)

private fun attachedJades(usbManager: UsbManager): List<UsbDevice> =
  usbManager.deviceList.values
    .filter { device -> JADE_USB_IDS.contains(Pair(device.vendorId, device.productId)) }
    .sortedBy { it.deviceName }

private fun usbDevice(intent: Intent): UsbDevice? =
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
  } else {
    @Suppress("DEPRECATION")
    intent.getParcelableExtra(UsbManager.EXTRA_DEVICE) as? UsbDevice
  }

internal fun usbPermissionPendingIntent(context: Context, deviceId: Int): PendingIntent {
  val intent = Intent("${context.packageName}.bitcoinerlab.jade.USB_PERMISSION")
    .setPackage(context.packageName)
  // UsbManager fills in EXTRA_DEVICE and EXTRA_PERMISSION_GRANTED when sending.
  val mutability = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    PendingIntent.FLAG_MUTABLE
  } else {
    0
  }
  return PendingIntent.getBroadcast(
    context, deviceId, intent, mutability or PendingIntent.FLAG_UPDATE_CURRENT
  )
}

private fun ensureUsbPermission(
  context: Context,
  usbManager: UsbManager,
  device: UsbDevice,
  timeoutMs: Int
) {
  if (usbManager.hasPermission(device)) return
  val action = "${context.packageName}.bitcoinerlab.jade.USB_PERMISSION"
  val latch = CountDownLatch(1)
  var granted = false
  val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != action) return
      if (usbDevice(intent)?.deviceName == device.deviceName) {
        granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
        latch.countDown()
      }
    }
  }
  val filter = IntentFilter(action)
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
    context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
  } else {
    @Suppress("DEPRECATION")
    context.registerReceiver(receiver, filter)
  }
  val pendingIntent = usbPermissionPendingIntent(context, device.deviceId)
  try {
    usbManager.requestPermission(device, pendingIntent)
    if (!latch.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
      throw JadeNativeException("Timed out waiting for Jade USB permission")
    }
    if (!granted) throw JadeNativeException("Jade USB permission was denied")
  } finally {
    pendingIntent.cancel()
    try {
      context.unregisterReceiver(receiver)
    } catch (_: Throwable) {}
  }
}

class BitcoinerlabJadeModule : Module() {
  private val lock = Object()
  private val sessions = mutableMapOf<String, JadeUsbSession>()

  override fun definition() = ModuleDefinition {
    Name(MODULE_NAME)
    Events("onUsbData", "onUsbError", "onUsbClose")

    OnDestroy {
      val ids = synchronized(lock) { sessions.keys.toList() }
      ids.forEach { id -> closeSession(id, false) }
    }

    AsyncFunction("listUsb") {
      val context = appContext.reactContext
        ?: throw JadeNativeException("React context is not available")
      val usbManager = context.getSystemService(Context.USB_SERVICE) as? UsbManager
        ?: throw JadeNativeException("USB manager is not available")
      attachedJades(usbManager).map { device ->
        mutableMapOf<String, Any>(
          "transport" to "usb",
          "deviceId" to device.deviceName,
          "vendorId" to device.vendorId,
          "productId" to device.productId
        ).apply {
          runCatching { device.productName }.getOrNull()?.let { name ->
            if (name.isNotBlank()) put("name", name)
          }
        }
      }
    }

    AsyncFunction("connectUsb") { paramsJSON: String ->
      val params = if (paramsJSON.isEmpty()) JSONObject() else JSONObject(paramsJSON)
      val timeoutMs = params.optInt("timeoutMs", DEFAULT_CONNECT_TIMEOUT_MS).coerceAtLeast(1)
      val selectedId = params.optString("deviceId").ifEmpty { null }
      val context = appContext.reactContext
        ?: throw JadeNativeException("React context is not available")
      val usbManager = context.getSystemService(Context.USB_SERVICE) as? UsbManager
        ?: throw JadeNativeException("USB manager is not available")
      val device = attachedJades(usbManager).firstOrNull { candidate ->
        selectedId == null || candidate.deviceName == selectedId
      } ?: throw JadeNativeException("No Jade USB device found")
      ensureUsbPermission(context, usbManager, device, timeoutMs)

      val driver = UsbSerialProber.getDefaultProber().probeDevice(device)
        ?: throw JadeNativeException("No serial driver found for Jade USB device")
      val port = driver.ports.firstOrNull()
        ?: throw JadeNativeException("Jade USB device has no serial port")
      val connection = usbManager.openDevice(device)
        ?: throw JadeNativeException("Failed to open Jade USB device")
      val sessionId = UUID.randomUUID().toString()
      var ioManager: SerialInputOutputManager? = null
      try {
        port.open(connection)
        port.setParameters(
          115200,
          UsbSerialPort.DATABITS_8,
          UsbSerialPort.STOPBITS_1,
          UsbSerialPort.PARITY_NONE
        )
        runCatching { port.dtr = false }
        runCatching { port.rts = false }
        val manager = SerialInputOutputManager(
          port,
          object : SerialInputOutputManager.Listener {
            override fun onNewData(data: ByteArray) {
              sendEvent(
                "onUsbData",
                mapOf(
                  "sessionId" to sessionId,
                  "data" to Base64.encodeToString(data, Base64.NO_WRAP)
                )
              )
            }

            override fun onRunError(error: Exception) {
              sendEvent(
                "onUsbError",
                mapOf(
                  "sessionId" to sessionId,
                  "message" to (error.message ?: "Jade USB read failed")
                )
              )
              closeSession(sessionId, true)
            }
          }
        )
        ioManager = manager
        synchronized(lock) {
          sessions[sessionId] = JadeUsbSession(sessionId, connection, port, manager)
        }
        manager.start()
        mapOf("id" to sessionId)
      } catch (error: Throwable) {
        synchronized(lock) { sessions.remove(sessionId) }
        try { ioManager?.stop() } catch (_: Throwable) {}
        try { port.close() } catch (_: Throwable) {}
        try { connection.close() } catch (_: Throwable) {}
        throw JadeNativeException("Failed to initialize Jade USB serial port", error)
      }
    }

    AsyncFunction("writeUsb") { sessionId: String, data: String ->
      val session = synchronized(lock) {
        sessions[sessionId]
      } ?: throw JadeNativeException("Unknown Jade USB session: $sessionId")
      val bytes = try {
        Base64.decode(data, Base64.DEFAULT)
      } catch (error: IllegalArgumentException) {
        throw JadeNativeException("Invalid Jade USB data", error)
      }
      session.port.write(bytes, IO_TIMEOUT_MS)
    }

    AsyncFunction("disconnectUsb") { sessionId: String ->
      closeSession(sessionId, false)
    }
  }

  private fun closeSession(sessionId: String, notify: Boolean) {
    val session = synchronized(lock) { sessions.remove(sessionId) } ?: return
    try { session.ioManager.stop() } catch (_: Throwable) {}
    try { session.port.close() } catch (_: Throwable) {}
    try { session.connection.close() } catch (_: Throwable) {}
    if (notify) sendEvent("onUsbClose", mapOf("sessionId" to sessionId))
  }
}
