//! The SDK of ZeroLux extensions' kernel modules, in Rust. A kernel module is a library the
//! kernel loads into itself and enables while running. It speaks with the kernel the same
//! JSON-RPC 2.0 a process part speaks over its standard input and output, carried here by a C
//! interface of four functions, so a module needs no particular version of Rust, and could be
//! written in another language:
//!
//! ```c
//! uint32_t zerolux_extension_abi(void);                  // ABI, 1
//! void *zerolux_extension_start(const Host *host);       // a running instance
//! void zerolux_extension_receive(void *instance, const uint8_t *message, size_t length);
//! void zerolux_extension_stop(void *instance);           // after which it is never called
//! typedef struct { const void *kernel;
//!                  void (*send)(const void *kernel, const uint8_t *message, size_t length); } Host;
//! ```
//!
//! Each message is one JSON-RPC object, as UTF-8, without a line end. `receive` returns at once:
//! the module answers later, from any thread, through `send`. An extension implements
//! [`Extension`] and exports it with [`export!`].

use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc,
    },
    time::Duration,
};

pub use serde_json::{self, Value, json};

/// The version of the C interface.
pub const ABI: u32 = 1;

/// How the kernel is reached: its handle and the function that carries a message to it.
#[repr(C)]
pub struct Host {
    pub kernel: *const c_void,
    pub send: extern "C" fn(kernel: *const c_void, message: *const u8, length: usize),
}

/// Who runs an action: `actor_id`, `session_id` and `by`.
pub type Caller = Value;

/// What an extension does when the kernel asks. Each call runs on a thread of its own, so a slow
/// one never holds the others, and can ask the kernel meanwhile through its [`Context`].
pub trait Extension: Send + Sync + 'static {
    /// Once enabled: what it brings (`actions`, `points`, `implements`, `events`, `subscribes`,
    /// `triggers`, `ui`), as the process part's `contributes`.
    fn initialize(&self, context: &Context) -> Result<Value, String>;
    /// Runs one of its actions.
    fn action(
        &self,
        context: &Context,
        name: &str,
        input: Value,
        caller: Caller,
    ) -> Result<Value, String>;
    /// Runs an operation of its implementation of another extension's point.
    fn point(
        &self,
        _context: &Context,
        point: &str,
        _implementation: &str,
        operation: &str,
        _input: Value,
    ) -> Result<Value, String> {
        Err(format!("No implementation of {point} `{operation}`"))
    }
    /// An event it hears.
    fn event(&self, _context: &Context, _name: &str, _payload: Value) {}
    /// Its settings changed; `context.settings()` has them.
    fn settings_changed(&self, _context: &Context) {}
}

/// What the module knows of itself, and how it asks the kernel.
pub struct Context {
    host: Host,
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>,
    state: Mutex<State>,
}

#[derive(Default, Clone)]
struct State {
    id: String,
    version: String,
    folder: String,
    settings: Value,
}

// The host's handle is the kernel's, valid while the module runs and safe from any thread.
unsafe impl Send for Context {}
unsafe impl Sync for Context {}

impl Context {
    fn send(&self, message: Value) {
        let mut message = message;
        message["jsonrpc"] = json!("2.0");
        let text = message.to_string();
        (self.host.send)(self.host.kernel, text.as_ptr(), text.len());
    }

    /// Its id, `publisher.name`.
    pub fn id(&self) -> String {
        self.state.lock().expect("state").id.clone()
    }

    pub fn version(&self) -> String {
        self.state.lock().expect("state").version.clone()
    }

    /// Its own folder, for its files: private to it and the kernel, removed with it.
    pub fn folder(&self) -> String {
        self.state.lock().expect("state").folder.clone()
    }

    /// Its settings, without secrets; kept current as they change.
    pub fn settings(&self) -> Value {
        self.state.lock().expect("state").settings.clone()
    }

    /// Asks the kernel, and waits a minute for its answer.
    pub fn ask(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, waiting) = mpsc::channel();
        self.waiting.lock().expect("waiting").insert(id, answer);
        self.send(json!({"id": id, "method": method, "params": params}));
        let answer = waiting
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| "The kernel did not answer in time".to_owned());
        self.waiting.lock().expect("waiting").remove(&id);
        answer?
    }

    /// Its settings with its secrets.
    pub fn secrets(&self) -> Result<Value, String> {
        Ok(self.ask("settings.get", json!({}))?["settings"].take())
    }

    /// A value it keeps in the workspace, or null.
    pub fn get_value(&self, key: &str) -> Result<Value, String> {
        Ok(self.ask("values.get", json!({"key": key}))?["value"].take())
    }

    /// Keeps a value; null removes it.
    pub fn set_value(&self, key: &str, value: Value) -> Result<(), String> {
        self.ask("values.set", json!({"key": key, "value": value}))
            .map(drop)
    }

    pub fn list_values(&self, prefix: &str) -> Result<Vec<String>, String> {
        let keys = self.ask("values.list", json!({"prefix": prefix}))?["keys"].take();
        serde_json::from_value(keys).map_err(|error| error.to_string())
    }

    /// The workspace's name, and its people and agents.
    pub fn workspace(&self) -> Result<Value, String> {
        self.ask("workspace.actors", json!({}))
    }

    /// Publishes one of its events.
    pub fn publish(&self, event: &str, payload: Value) -> Result<(), String> {
        self.ask("events.publish", json!({"name": event, "payload": payload}))
            .map(drop)
    }

    /// Runs another extension's action.
    pub fn run(&self, extension: &str, action: &str, input: Value) -> Result<Value, String> {
        Ok(self.ask(
            "actions.run",
            json!({"extension": extension, "action": action, "input": input}),
        )?["result"]
            .take())
    }

    /// Calls an operation of one implementation of a point.
    pub fn call(
        &self,
        point: &str,
        implementation: &str,
        operation: &str,
        input: Value,
    ) -> Result<Value, String> {
        Ok(self.ask(
            "points.call",
            json!({"point": point, "implementation": implementation,
                    "operation": operation, "input": input}),
        )?["result"]
            .take())
    }

    /// A new tree for one of its `remote` views, shown with `context`.
    pub fn update_view(&self, name: &str, context: Value, tree: Value) -> Result<(), String> {
        self.ask(
            "views.update",
            json!({"name": name, "context": context, "tree": tree}),
        )
        .map(drop)
    }

    pub fn log(&self, message: &str) {
        self.send(json!({"method": "log", "params": {"message": message}}));
    }
}

/// A running module: its extension, and how it answers.
pub struct Instance {
    extension: Arc<dyn Extension>,
    context: Arc<Context>,
}

impl Instance {
    pub fn new(extension: Arc<dyn Extension>, host: &Host) -> Self {
        Self {
            extension,
            context: Arc::new(Context {
                host: Host {
                    kernel: host.kernel,
                    send: host.send,
                },
                next: AtomicU64::new(1),
                waiting: Mutex::default(),
                state: Mutex::default(),
            }),
        }
    }

    /// A message from the kernel: an answer to what the module asked, a request, or a notice.
    pub fn receive(&self, bytes: &[u8]) {
        let Ok(message) = serde_json::from_slice::<Value>(bytes) else {
            return;
        };
        let method = message["method"].as_str().map(str::to_owned);
        let id = message.get("id").cloned();
        match (method, id) {
            (None, Some(id)) => {
                let Some(id) = id.as_u64() else { return };
                let answer = match message.get("error") {
                    Some(error) => Err(error["message"]
                        .as_str()
                        .unwrap_or("The kernel refused")
                        .to_owned()),
                    None => Ok(message["result"].clone()),
                };
                if let Some(waiting) = self.context.waiting.lock().expect("waiting").remove(&id) {
                    let _ = waiting.send(answer);
                }
            }
            (Some(method), id) => {
                let (extension, context) = (self.extension.clone(), self.context.clone());
                let params = message["params"].clone();
                std::thread::spawn(move || {
                    let answer = handle(&*extension, &context, &method, params);
                    if let Some(id) = id {
                        context.send(match answer {
                            Ok(result) => json!({"id": id, "result": result}),
                            Err(error) => json!({"id": id,
                                "error": {"code": -32000, "message": error}}),
                        });
                    }
                });
            }
            (None, None) => {}
        }
    }
}

fn handle(
    extension: &dyn Extension,
    context: &Context,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let text = |key: &str| params[key].as_str().unwrap_or_default().to_owned();
    match method {
        "initialize" => {
            {
                let mut state = context.state.lock().expect("state");
                state.id = params["extension"]["id"]
                    .as_str()
                    .unwrap_or_default()
                    .into();
                state.version = params["extension"]["version"]
                    .as_str()
                    .unwrap_or_default()
                    .into();
                state.folder = text("folder");
                state.settings = params["settings"].clone();
            }
            Ok(json!({"contributes": extension.initialize(context)?}))
        }
        "action.run" => extension.action(
            context,
            &text("action"),
            params["input"].clone(),
            params["caller"].clone(),
        ),
        "point.call" => extension.point(
            context,
            &text("point"),
            &text("implementation"),
            &text("operation"),
            params["input"].clone(),
        ),
        "event" => {
            extension.event(context, &text("name"), params["payload"].clone());
            Ok(Value::Null)
        }
        "settings" => {
            context.state.lock().expect("state").settings = params["settings"].clone();
            extension.settings_changed(context);
            Ok(Value::Null)
        }
        "shutdown" => Ok(Value::Null),
        other => Err(format!("Unknown method `{other}`")),
    }
}

/// Exports an extension as a kernel module: `export!(Tally::default)` makes the four C
/// functions the kernel calls, with an instance made by the expression given.
#[macro_export]
macro_rules! export {
    ($make:expr) => {
        #[unsafe(no_mangle)]
        pub extern "C" fn zerolux_extension_abi() -> u32 {
            $crate::ABI
        }

        /// # Safety
        /// `host` is the kernel's, valid while the instance runs.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn zerolux_extension_start(
            host: *const $crate::Host,
        ) -> *mut ::std::ffi::c_void {
            let extension: ::std::sync::Arc<dyn $crate::Extension> =
                ::std::sync::Arc::new(($make)());
            let instance = $crate::Instance::new(extension, unsafe { &*host });
            ::std::boxed::Box::into_raw(::std::boxed::Box::new(instance)).cast()
        }

        /// # Safety
        /// `instance` came from `zerolux_extension_start`, and `message` holds `length` bytes.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn zerolux_extension_receive(
            instance: *mut ::std::ffi::c_void,
            message: *const u8,
            length: usize,
        ) {
            let instance = unsafe { &*instance.cast::<$crate::Instance>() };
            instance.receive(unsafe { ::std::slice::from_raw_parts(message, length) });
        }

        /// # Safety
        /// `instance` came from `zerolux_extension_start`; it is not used again.
        #[unsafe(no_mangle)]
        pub unsafe extern "C" fn zerolux_extension_stop(instance: *mut ::std::ffi::c_void) {
            drop(unsafe { ::std::boxed::Box::from_raw(instance.cast::<$crate::Instance>()) });
        }
    };
}
