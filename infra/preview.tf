# Application request logs are disabled; ingress URL logs also contain app secrets.
resource "google_logging_project_exclusion" "preview_requests" {
  count       = var.preview_origin != "" ? 1 : 0
  name        = "preview-requests"
  description = "Do not retain preview application paths or query strings in Cloud Run request logs"
  filter = <<-FILTER
    resource.type="cloud_run_revision"
    log_id("run.googleapis.com/requests")
    httpRequest.requestUrl =~ "^https://p[1-9][0-9]{0,4}-o[0-9a-f-]{36}\\.${replace(trimprefix(var.preview_origin, "https://"), ".", "\\\\.")}([/:?]|$)"
  FILTER
}
