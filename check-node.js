const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error('Node 20.19+ required (mcp-use needs require(ESM)). Current:', process.versions.node);
  process.exit(1);
}
