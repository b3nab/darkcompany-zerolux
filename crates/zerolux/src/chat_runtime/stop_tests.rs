use super::*;

async fn adapter(result: Result<()>, finished: bool) -> AgentTask {
    let (stop, mut stopped) = watch::channel(false);
    let task = tokio::spawn(async move {
        if !finished {
            stopped.wait_for(|value| *value).await.unwrap();
        }
        result
    });
    if finished {
        // Force the adapter to finish before Stop inspects it, without consuming its result.
        tokio::time::timeout(Duration::from_secs(5), async {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    AgentTask {
        stop,
        task,
        subscriber: None,
        stop_note: None,
        settings: None,
    }
}

#[tokio::test]
async fn stop_recognizes_revocation_before_and_during_shutdown_without_hiding_cancel_failure() {
    for finished in [true, false] {
        let mut revoked = adapter(Err(crate::chat_driver::Revoked.into()), finished).await;
        let (gone, driver, subscriber) = revoked.finish_stop().await;
        assert_eq!(gone, finished);
        assert!(driver.is_ok());
        assert!(subscriber.is_ok());

        let mut unconfirmed = adapter(
            Err(std::io::Error::from(std::io::ErrorKind::TimedOut).into()),
            finished,
        )
        .await;
        let (gone, driver, subscriber) = unconfirmed.finish_stop().await;
        assert_eq!(gone, finished);
        assert_eq!(
            driver
                .unwrap_err()
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .kind(),
            std::io::ErrorKind::TimedOut
        );
        assert!(subscriber.is_ok());
    }
}
