# Optional authoritative public DNS. Registrar delegation remains an explicit operator step after inventory verification.
variable "manage_dns" {
  type        = bool
  default     = false
  description = "Prepare a protected Cloud DNS zone for custom_domain without changing registrar nameservers."
  validation {
    condition     = !var.manage_dns || var.custom_domain != ""
    error_message = "Managed DNS requires an explicit custom_domain."
  }
}
variable "dns_records" {
  type = map(object({
    name    = string
    type    = string
    ttl     = number
    rrdatas = list(string)
  }))
  default     = {}
  description = "Reviewed existing and Firebase record sets, using fully qualified names and DNS presentation-format values. Exclude apex NS/SOA."
  validation {
    condition     = var.manage_dns || length(var.dns_records) == 0
    error_message = "DNS records require manage_dns=true."
  }
  validation {
    condition = alltrue([for record in values(var.dns_records) :
      record.name == lower(record.name) && (record.name == "${var.custom_domain}." || endswith(record.name, ".${var.custom_domain}.")) &&
      contains(["A", "AAAA", "CAA", "CNAME", "DS", "HTTPS", "MX", "NAPTR", "NS", "PTR", "SRV", "SSHFP", "SVCB", "TLSA", "TXT"], record.type) &&
      !(record.name == "${var.custom_domain}." && record.type == "NS") &&
      record.ttl >= 0 && record.ttl <= 2147483647 && floor(record.ttl) == record.ttl &&
      length(record.rrdatas) > 0 && alltrue([for value in record.rrdatas : trimspace(value) != ""])
    ])
    error_message = "Use in-zone FQDNs, supported record types, integer TTLs and nonempty values. Google owns apex NS/SOA."
  }
  validation {
    condition     = length(distinct([for record in values(var.dns_records) : "${record.name}/${record.type}"])) == length(var.dns_records)
    error_message = "Combine values for each name/type into one record set."
  }
}
resource "google_dns_managed_zone" "app" {
  count         = var.manage_dns ? 1 : 0
  project       = data.google_project.app.project_id
  name          = "calibrate-public"
  dns_name      = "${var.custom_domain}."
  description   = "Calibrate production public DNS; registrar delegation is managed separately."
  visibility    = "public"
  force_destroy = false
  # The existing delegation has no DS record. DNSSEC activation requires a coordinated registrar update.
  dnssec_config {
    state = "off"
  }
  lifecycle {
    prevent_destroy = true
  }
}
resource "google_dns_record_set" "app" {
  for_each     = var.dns_records
  project      = data.google_project.app.project_id
  managed_zone = google_dns_managed_zone.app[0].name
  name         = each.value.name
  type         = each.value.type
  ttl          = each.value.ttl
  rrdatas      = each.value.rrdatas
}
output "dns_nameservers" {
  description = "Enter these at the registrar only after the existing zone inventory and new records have been verified."
  value       = try(google_dns_managed_zone.app[0].name_servers, [])
}
