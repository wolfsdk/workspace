/** @jsxImportSource preact */
import "@wolfsdk/review/auto";
import { render } from "preact";
import { App } from "./app.tsx";
import { shareTokenOf } from "./lib/share.ts";
import { SharedPage } from "./ui/shared-view.tsx";
import "./styles.css";

// A share link's page is routed before the workspace: `App` takes a token, asks a hosting front for the session and
// may send the browser to sign in, and a visitor with a link must meet none of that.
const shared = shareTokenOf(location.pathname);
render(shared !== null ? <SharedPage token={shared} /> : <App />, document.getElementById("app")!);
