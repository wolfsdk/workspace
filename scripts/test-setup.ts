// Loaded before every test file of this workspace (see bunfig.toml).
//
// Many suites here start a server, a socket or a child process. On an idle machine such a test takes
// milliseconds; on a loaded build host the same test has taken over ten seconds, and the 5 s default failed
// it. This default applies to every file; a file that calls setDefaultTimeout itself keeps its own.
import { setDefaultTimeout } from "bun:test";

setDefaultTimeout(120_000);
