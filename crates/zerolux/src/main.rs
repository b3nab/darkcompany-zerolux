#[tokio::main]
async fn main() -> anyhow::Result<()> {
    zerolux::cli::init_logging();
    zerolux::cli::run().await
}
