// Shared multiline-secret fixture used by both the mock pass-cli and the
// regression tests (critical fix #1/#5: multiline values must survive
// byte-exact, including the trailing newline).
export const PEM_KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
  'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n' +
  'QyNTUxOQAAACBtb2NrLWtleS1ieXRlcy1mb3ItdGVzdGluZy1vbmx5LW5vdC1yZWFsAAAA\n' +
  '-----END OPENSSH PRIVATE KEY-----\n'
