use objc2::{rc::Retained, runtime::ProtocolObject};
use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

/// Keeps an app-managed kernel responsive until its services have shut down.
/// Each local kernel owns one activity; external connections own none.
pub struct LocalKernel(Retained<ProtocolObject<dyn NSObjectProtocol>>);

impl LocalKernel {
    pub fn new() -> Self {
        Self(
            NSProcessInfo::processInfo().beginActivityWithOptions_reason(
                NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
                &NSString::from_str("Running a local ZeroLux workspace"),
            ),
        )
    }
}

// SAFETY: Apple demonstrates beginning an activity on the caller's thread and
// ending it in an NSOperationQueue. This opaque token is created only by begin,
// never exposed or cloned, and used only by endActivity and its final release.
// NSProcessInfo is thread-safe; this guard permits ownership transfer, not sharing.
// https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/PrioritizeWorkAtTheAppLevel.html
unsafe impl Send for LocalKernel {}

impl Drop for LocalKernel {
    fn drop(&mut self) {
        // SAFETY: the private token came from beginActivityWithOptions:reason:,
        // and this uniquely owned guard ends it exactly once before releasing it.
        unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
    }
}
