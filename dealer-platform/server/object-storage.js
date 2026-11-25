import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export class ObjectStorage {
  constructor(env = process.env) {
    const { S3_ENDPOINT_URL, S3_BUCKET_NAME, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_BASE_URL } = env;
    this.bucket = S3_BUCKET_NAME;
    this.publicBaseUrl = S3_PUBLIC_BASE_URL?.replace(/\/$/, "");
    if (S3_ENDPOINT_URL && this.bucket && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY && this.publicBaseUrl) {
      this.client = new S3Client({ endpoint: S3_ENDPOINT_URL, region: "auto", forcePathStyle: true, credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY } });
    }
  }
  get configured() { return Boolean(this.client); }
  async upload(key, body, contentType = "image/webp") {
    if (!this.client) throw new Error("S3-compatible image storage is not configured");
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, CacheControl: "public, max-age=31536000, immutable" }));
    return `${this.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }
  async deleteUrl(url) {
    if (!this.client || typeof url !== "string" || !url.startsWith(`${this.publicBaseUrl}/`)) return;
    const key = decodeURIComponent(url.slice(this.publicBaseUrl.length + 1));
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
