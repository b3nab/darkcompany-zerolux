package os.darkcompany.zerolux.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.Inet6Address
import java.net.InetAddress

private const val TYPE = "_zerolux._tcp"

/**
 * ZeroLux kernels announcing themselves on the local network (`_zerolux._tcp`), through
 * Android's own service discovery: each one with its TXT record and address, as it comes,
 * changes or goes.
 */
class ZeroluxDiscoveryModule : Module() {
  private val nsd: NsdManager?
    get() = appContext.reactContext?.getSystemService(Context.NSD_SERVICE) as? NsdManager
  private var discovery: NsdManager.DiscoveryListener? = null
  private val watching = mutableMapOf<String, NsdManager.ServiceInfoCallback>()

  override fun definition() = ModuleDefinition {
    Name("ZeroluxDiscovery")

    Events("found", "lost", "state")

    Function("start") { start() }

    Function("stop") { stop() }

    OnDestroy { stop() }
  }

  @Synchronized
  private fun start() {
    stop()
    val manager = nsd ?: return sendEvent("state", mapOf("state" to "failed"))
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) =
        sendEvent("state", mapOf("state" to "ready"))

      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) =
        sendEvent("state", mapOf("state" to "failed"))

      override fun onServiceFound(info: NsdServiceInfo) = follow(manager, info)

      override fun onServiceLost(info: NsdServiceInfo) {
        synchronized(this@ZeroluxDiscoveryModule) { watching.remove(info.serviceName) }
          ?.let { unwatch(manager, it) }
        sendEvent("lost", mapOf("service" to info.serviceName))
      }

      override fun onDiscoveryStopped(serviceType: String) = Unit

      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
    }
    manager.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    discovery = listener
  }

  @Synchronized
  private fun stop() {
    val manager = nsd
    discovery?.let { runCatching { manager?.stopServiceDiscovery(it) } }
    discovery = null
    if (manager != null) watching.values.forEach { unwatch(manager, it) }
    watching.clear()
  }

  private fun unwatch(manager: NsdManager, callback: NsdManager.ServiceInfoCallback) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
      runCatching { manager.unregisterServiceInfoCallback(callback) }
  }

  /** A found service's address and TXT record, followed as they change where Android can. */
  private fun follow(manager: NsdManager, info: NsdServiceInfo) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      val callback = object : NsdManager.ServiceInfoCallback {
        override fun onServiceUpdated(updated: NsdServiceInfo) =
          found(updated, updated.hostAddresses)

        override fun onServiceLost() = Unit

        override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit

        override fun onServiceInfoCallbackUnregistered() = Unit
      }
      synchronized(this) {
        if (watching.containsKey(info.serviceName)) return
        watching[info.serviceName] = callback
      }
      manager.registerServiceInfoCallback(info, Runnable::run, callback)
    } else {
      @Suppress("DEPRECATION")
      manager.resolveService(
        info,
        object : NsdManager.ResolveListener {
          override fun onServiceResolved(resolved: NsdServiceInfo) =
            found(resolved, listOfNotNull(@Suppress("DEPRECATION") resolved.host))

          override fun onResolveFailed(failed: NsdServiceInfo, errorCode: Int) = Unit
        },
      )
    }
  }

  private fun found(info: NsdServiceInfo, hosts: List<InetAddress>) {
    // IPv4 first: an address a URL takes as it is.
    val host = hosts.firstOrNull { it !is Inet6Address } ?: hosts.firstOrNull() ?: return
    val address =
      if (host is Inet6Address) "[${host.hostAddress?.replace("%", "%25")}]" else host.hostAddress
    val txt = info.attributes.mapValues { (_, value) -> value?.toString(Charsets.UTF_8) ?: "" }
    sendEvent(
      "found",
      mapOf("service" to info.serviceName, "txt" to txt, "address" to address, "port" to info.port),
    )
  }
}
