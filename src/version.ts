/**
 * Extension version, recorded in every telemetry run header.
 *
 * Declared here rather than read from package.json at runtime so the extension has no
 * filesystem dependency at import time. A test pins it to package.json so the two cannot
 * drift, which matters because this value identifies which code produced a study's data.
 */
export const EXTENSION_VERSION = "0.1.0";
