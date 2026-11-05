package com.bitcoinerlab.jadereactnative

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbManager
import android.os.Build
import android.os.Looper
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30, 31, 35])
class UsbPermissionTest {
  @Test
  fun permissionCallbackIncludesSystemResult() {
    val context = RuntimeEnvironment.getApplication()
    val pendingIntent = usbPermissionPendingIntent(context, 42)
    val action = "${context.packageName}.bitcoinerlab.jade.USB_PERMISSION"
    var result: Intent? = null
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        result = intent
      }
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      context.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("DEPRECATION")
      context.registerReceiver(receiver, IntentFilter(action))
    }
    try {
      // The USB service delivers the permission decision as a fill-in Intent.
      pendingIntent.send(context, 0, Intent().putExtra(UsbManager.EXTRA_PERMISSION_GRANTED, true))
      shadowOf(Looper.getMainLooper()).idle()

      assertNotNull(result)
      assertEquals(context.packageName, result?.`package`)
      assertEquals(true, result?.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false))
    } finally {
      pendingIntent.cancel()
      context.unregisterReceiver(receiver)
    }
  }
}
