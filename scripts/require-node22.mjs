const [major, minor] = process.versions.node.split(".").map(Number);
if (major !== 22 || minor < 20) {
  console.error(`Mission Control requires Node.js >=22.20.0 <23; found ${process.versions.node}. Run \`nvm use\`.`);
  process.exit(1);
}
