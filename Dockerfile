# Container image for triage pipeline sandboxes. Pin the base image to the
# exact @cloudflare/sandbox SDK version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.3

RUN apt-get update \
	&& apt-get install -y --no-install-recommends git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

# Package manager for reproducing/building target repositories.
RUN npm install -g pnpm@10

EXPOSE 8080
