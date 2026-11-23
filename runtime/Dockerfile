# The display's Linux runtime: everything the shell runs under its bundled proot.
# Node (Vite + bridge) and git (undo). No AI program: the tablet has no coding agent (making apps is someone's own
# Claude or ChatGPT on a computer, through the workshop), and the assistant's models are OpenAI's, through the cloud.
FROM --platform=linux/arm64 ubuntu:24.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ca-certificates curl xz-utils procps \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man
RUN curl -fsSL https://nodejs.org/dist/v22.23.4/node-v22.23.4-linux-arm64.tar.xz | tar -xJ -C /opt \
 && ln -s /opt/node-v22.23.4-linux-arm64/bin/node /opt/node-v22.23.4-linux-arm64/bin/npm /opt/node-v22.23.4-linux-arm64/bin/npx /usr/local/bin/ \
 && rm -rf /opt/node-*/include /opt/node-*/share
RUN git config --system user.name Display && git config --system user.email display@localhost \
 && git config --system --add safe.directory '*'
