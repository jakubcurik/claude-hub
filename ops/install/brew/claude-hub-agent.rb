# SPDX-License-Identifier: Apache-2.0
class ClaudeHubAgent < Formula
  desc "Local daemon for the Claude Hub team marketplace"
  homepage "https://github.com/animato/claude-hub"
  version "0.1.0"

  if Hardware::CPU.arm?
    url "https://github.com/animato/claude-hub/releases/download/v#{version}/claude-hub-agent_darwin_arm64.tar.gz"
    sha256 "REPLACE_AT_RELEASE_TIME"
  else
    url "https://github.com/animato/claude-hub/releases/download/v#{version}/claude-hub-agent_darwin_amd64.tar.gz"
    sha256 "REPLACE_AT_RELEASE_TIME"
  end

  def install
    bin.install "claude-hub-agent"
  end

  service do
    run [opt_bin/"claude-hub-agent", "run"]
    keep_alive true
    log_path var/"log/claude-hub-agent.log"
    error_log_path var/"log/claude-hub-agent.err.log"
  end

  test do
    assert_match "claude-hub-agent", shell_output("#{bin}/claude-hub-agent --version")
  end
end
