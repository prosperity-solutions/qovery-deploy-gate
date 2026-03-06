FROM alpine:3.23.3
LABEL org.opencontainers.image.description="qovery-deploy-gate sidecar — lightweight readiness gate coordinator injected into application pods"
RUN apk add --no-cache curl jq
COPY gate-check.sh /gate-check.sh
RUN chmod +x /gate-check.sh
USER 65534:65534
ENTRYPOINT ["/gate-check.sh"]
