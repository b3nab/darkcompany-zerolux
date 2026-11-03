//! macOS asks an app to quit with an Apple Event: from the Dock, an AppleScript `quit`, a logout
//! or a shutdown. AppKit's own answer ends the process at once, so the app's kernel never stops
//! the processes it runs, and tao has no `applicationShouldTerminate:` to ask first. This answer
//! takes the app's own way out instead, which stops the kernel and waits for it.
use objc2::{DefinedClass, MainThreadOnly, define_class, msg_send, rc::Retained, sel};
use objc2_foundation::{
    MainThreadMarker, NSAppleEventDescriptor, NSAppleEventManager, NSObject, NSObjectProtocol,
};

/// `kCoreEventClass` and `kAEQuitApplication`: the system's quit.
const CORE_EVENTS: u32 = u32::from_be_bytes(*b"aevt");
const QUIT: u32 = u32::from_be_bytes(*b"quit");

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "ZeroLuxQuit"]
    #[ivars = tauri::AppHandle]
    struct Quit;

    unsafe impl NSObjectProtocol for Quit {}

    impl Quit {
        #[unsafe(method(handleQuit:withReply:))]
        fn handle(&self, _event: &NSAppleEventDescriptor, _reply: &NSAppleEventDescriptor) {
            self.ivars().exit(0);
        }
    }
);

/// From now on a quit from the system goes the app's own way out. Once AppKit has finished
/// launching: it puts its own answer in place then.
pub fn install(app: &tauri::AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let handler = Quit::alloc(mtm).set_ivars(app.clone());
    let handler: Retained<Quit> = unsafe { msg_send![super(handler), init] };
    // SAFETY: the handler answers `handleQuit:withReply:` with the two descriptors AppKit
    // passes, on the main thread, where Apple Events are dispatched.
    unsafe {
        let _: () = msg_send![
            &*NSAppleEventManager::sharedAppleEventManager(),
            setEventHandler: &*handler,
            andSelector: sel!(handleQuit:withReply:),
            forEventClass: CORE_EVENTS,
            andEventID: QUIT
        ];
    }
    // The manager does not keep its handler: it lives as long as the app.
    std::mem::forget(handler);
}
