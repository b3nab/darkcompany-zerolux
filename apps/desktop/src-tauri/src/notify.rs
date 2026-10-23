//! A request as a system notification, answered from it: Allow once or Deny where it is a
//! permission, and a click opens it in the app. The tray's panel decides what is shown and
//! hears the answer, as it hears its own buttons.
use serde::Deserialize;
use std::{collections::HashSet, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// A request to show, from the tray's panel.
#[derive(Deserialize)]
pub struct Ask {
    profile: String,
    id: String,
    /// "aspen wants to run".
    title: String,
    /// The workspace it comes from.
    subtitle: String,
    /// The command, files or question.
    body: String,
    /// A permission, answered from the notification; anything else only opens.
    choices: bool,
}

/// The notifications shown and not answered yet, by `<profile>|<id>`.
#[derive(Default)]
pub struct Shown(Mutex<HashSet<String>>);

const APPROVE: &str = "approve";
const DENY: &str = "deny";

/// What the person did with a notification: an answer, or a click that opens the request.
fn answered(app: &AppHandle, key: &str, action: &str) {
    let Some((profile, id)) = key.split_once('|') else {
        return;
    };
    app.state::<Shown>()
        .0
        .lock()
        .expect("notifications lock")
        .remove(key);
    let request = serde_json::json!({ "profile": profile, "id": id });
    let _ = match action {
        APPROVE | DENY => {
            let choice = if action == APPROVE { "once" } else { "deny" };
            let chosen = serde_json::json!({ "profile": profile, "id": id, "choice": choice });
            app.emit_to(crate::tray::PANEL, "zerolux-tray-choose", chosen)
        }
        "" | "default" => app.emit_to(crate::tray::PANEL, "zerolux-tray-request", request),
        // A notification closed or dismissed: nothing is answered.
        _ => Ok(()),
    };
}

/// Ready to show requests: macOS asks the person once whether ZeroLux may.
pub fn install(app: &AppHandle) {
    app.manage(Shown::default());
    #[cfg(target_os = "macos")]
    mac::install(app);
}

/// A request shown, once.
pub fn show(app: &AppHandle, ask: Ask) {
    let key = format!("{}|{}", ask.profile, ask.id);
    if !app
        .state::<Shown>()
        .0
        .lock()
        .expect("notifications lock")
        .insert(key.clone())
    {
        return;
    }
    #[cfg(target_os = "macos")]
    mac::show(&key, &ask);
    #[cfg(target_os = "windows")]
    {
        use tauri_winrt_notification::Toast;
        let app_id = app.config().identifier.clone();
        let handle = app.clone();
        let mut toast = Toast::new(&app_id)
            .title(&ask.title)
            .text1(&ask.subtitle)
            .text2(&ask.body);
        if ask.choices {
            toast = toast
                .add_button("Allow once", APPROVE)
                .add_button("Deny", DENY);
        }
        let shown = toast
            .on_activated(move |action| {
                answered(&handle, &key, action.as_deref().unwrap_or(""));
                Ok(())
            })
            .show();
        if let Err(error) = shown {
            eprintln!("A request could not be notified: {error}");
        }
    }
    #[cfg(target_os = "linux")]
    {
        let handle = app.clone();
        std::thread::spawn(move || {
            let mut notification = notify_rust::Notification::new();
            notification
                .appname("ZeroLux")
                .summary(&ask.title)
                .body(&format!("{}\n{}", ask.subtitle, ask.body))
                .action("default", "Open");
            if ask.choices {
                notification
                    .action(APPROVE, "Allow once")
                    .action(DENY, "Deny");
            }
            match notification.show() {
                Ok(shown) => shown.wait_for_action(|action| answered(&handle, &key, action)),
                Err(error) => eprintln!("A request could not be notified: {error}"),
            }
        });
    }
}

/// The notifications of requests that no longer wait, answered elsewhere, taken away.
pub fn keep_only(app: &AppHandle, waiting: &HashSet<String>) {
    let state = app.state::<Shown>();
    let gone: Vec<String> = {
        let mut shown = state.0.lock().expect("notifications lock");
        let gone = shown.difference(waiting).cloned().collect();
        shown.retain(|key| waiting.contains(key));
        gone
    };
    #[cfg(target_os = "macos")]
    mac::withdraw(&gone);
    // Windows' and Linux's notifications go by themselves; an answer to one that no longer
    // waits is refused by its kernel.
    #[cfg(not(target_os = "macos"))]
    let _ = gone;
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{APPROVE, Ask, DENY, answered};
    use objc2::{AllocAnyThread, define_class, msg_send, rc::Retained, runtime::ProtocolObject};
    use objc2_foundation::{NSArray, NSBundle, NSObject, NSObjectProtocol, NSSet, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationAction,
        UNNotificationActionOptions, UNNotificationCategory, UNNotificationCategoryOptions,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
    };
    use std::sync::OnceLock;
    use tauri::AppHandle;

    const PERMISSION: &str = "zerolux-permission";
    static APP: OnceLock<AppHandle> = OnceLock::new();

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and this class adds no state and
        // implements no `Drop`.
        #[unsafe(super(NSObject))]
        #[name = "ZeroLuxNotifications"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // Shown while ZeroLux is in front too: a request waits wherever you look.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                completion.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List
                    | UNNotificationPresentationOptions::Sound,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion: &block2::DynBlock<dyn Fn()>,
            ) {
                let key = response.notification().request().identifier().to_string();
                let action = response.actionIdentifier().to_string();
                let action = if action.starts_with("com.apple.UNNotificationDefault") {
                    "default".to_owned()
                } else {
                    action
                };
                if let Some(app) = APP.get() {
                    answered(app, &key, &action);
                }
                completion.call(());
            }
        }
    );

    /// Notifications need the app's bundle: a build run from source has none and shows them
    /// only through the page.
    fn center() -> Option<objc2::rc::Retained<UNUserNotificationCenter>> {
        NSBundle::mainBundle()
            .bundleIdentifier()
            .map(|_| UNUserNotificationCenter::currentNotificationCenter())
    }

    pub fn install(app: &AppHandle) {
        let Some(center) = center() else {
            return;
        };
        let _ = APP.set(app.clone());
        let delegate: Retained<Delegate> =
            unsafe { msg_send![super(Delegate::alloc().set_ivars(())), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The center holds its delegate weakly: this one lives as long as the app.
        std::mem::forget(delegate);
        let actions = NSArray::from_retained_slice(&[
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(APPROVE),
                &NSString::from_str("Allow once"),
                UNNotificationActionOptions::empty(),
            ),
            UNNotificationAction::actionWithIdentifier_title_options(
                &NSString::from_str(DENY),
                &NSString::from_str("Deny"),
                UNNotificationActionOptions::Destructive,
            ),
        ]);
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(PERMISSION),
                &actions,
                &NSArray::new(),
                UNNotificationCategoryOptions::empty(),
            );
        center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
        let asked = block2::RcBlock::new(|_granted, _error| {});
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &asked,
        );
    }

    pub fn show(key: &str, ask: &Ask) {
        let Some(center) = center() else {
            return;
        };
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&ask.title));
        content.setSubtitle(&NSString::from_str(&ask.subtitle));
        content.setBody(&NSString::from_str(&ask.body));
        content.setThreadIdentifier(&NSString::from_str(&ask.profile));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        if ask.choices {
            content.setCategoryIdentifier(&NSString::from_str(PERMISSION));
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(key),
            &content,
            None,
        );
        center.addNotificationRequest_withCompletionHandler(&request, None);
    }

    pub fn withdraw(keys: &[String]) {
        let Some(center) = center() else {
            return;
        };
        if keys.is_empty() {
            return;
        }
        let keys: Vec<_> = keys.iter().map(|key| NSString::from_str(key)).collect();
        center.removeDeliveredNotificationsWithIdentifiers(&NSArray::from_retained_slice(&keys));
    }
}
