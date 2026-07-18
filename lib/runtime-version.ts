const minimum = { major: 22, minor: 20 } as const;

export function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  if (major !== minimum.major || minor < minimum.minor) {
    throw new Error(
      `Mission Control requires Node.js >=${minimum.major}.${minimum.minor}.0 <23; found ${version}. Run \`nvm use\` before installing dependencies or starting a worker.`,
    );
  }
}
