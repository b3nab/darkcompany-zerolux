# S3

Buckets as Storage locations, live: Amazon S3, Cloudflare R2, MinIO and any service that speaks S3.

## Set up

1. In Files, choose **Add location**, then S3.
2. Enter the bucket, and its region for Amazon S3 or its endpoint for another service.
3. Enter an access key that can read and write the bucket.

A location can be a folder of the bucket. An empty folder is kept as an empty object whose name ends with a slash.
