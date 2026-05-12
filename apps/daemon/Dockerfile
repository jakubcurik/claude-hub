FROM golang:1.26-alpine AS builder
WORKDIR /repo

COPY go.work ./
COPY apps/daemon/go.mod apps/daemon/go.mod
COPY apps/daemon apps/daemon

RUN go test ./apps/daemon/...
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/claude-hub-daemon ./apps/daemon/cmd/claude-hub-daemon

FROM alpine:3.22 AS runner
RUN apk add --no-cache ca-certificates wget
COPY --from=builder /out/claude-hub-daemon /usr/local/bin/claude-hub-daemon

EXPOSE 17373
ENTRYPOINT ["claude-hub-daemon"]
