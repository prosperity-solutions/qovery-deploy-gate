{{/*
Expand the name of the chart.
*/}}
{{- define "qovery-deploy-gate.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "qovery-deploy-gate.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "qovery-deploy-gate.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "qovery-deploy-gate.labels" -}}
helm.sh/chart: {{ include "qovery-deploy-gate.chart" . }}
{{ include "qovery-deploy-gate.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "qovery-deploy-gate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "qovery-deploy-gate.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Gate selector labels
*/}}
{{- define "qovery-deploy-gate.gate.selectorLabels" -}}
app.kubernetes.io/name: {{ include "qovery-deploy-gate.name" . }}-gate
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: gate
{{- end }}

{{/*
Gate labels
*/}}
{{- define "qovery-deploy-gate.gate.labels" -}}
helm.sh/chart: {{ include "qovery-deploy-gate.chart" . }}
{{ include "qovery-deploy-gate.gate.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Webhook selector labels
*/}}
{{- define "qovery-deploy-gate.webhook.selectorLabels" -}}
app.kubernetes.io/name: {{ include "qovery-deploy-gate.name" . }}-webhook
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: webhook
{{- end }}

{{/*
Webhook labels
*/}}
{{- define "qovery-deploy-gate.webhook.labels" -}}
helm.sh/chart: {{ include "qovery-deploy-gate.chart" . }}
{{ include "qovery-deploy-gate.webhook.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
cert-manager issuer name (defaults to chart-scoped selfsigned issuer)
*/}}
{{- define "qovery-deploy-gate.issuerName" -}}
{{- if .Values.certManager.issuerRef.name }}
{{- .Values.certManager.issuerRef.name }}
{{- else }}
{{- printf "%s-selfsigned" (include "qovery-deploy-gate.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Database URL
*/}}
{{- define "qovery-deploy-gate.databaseUrl" -}}
{{- if .Values.gate.database.external }}
{{- .Values.gate.database.url }}
{{- else }}
{{- printf "postgresql://%s:%s@%s-postgresql:5432/%s" .Values.postgresql.auth.username (.Values.postgresql.auth.password | urlquery) (include "qovery-deploy-gate.fullname" .) .Values.postgresql.auth.database }}
{{- end }}
{{- end }}
