# @wolfsdk/protocol

The contracts of the Wolf engine and of Wolf Workspace, as TypeScript types, JSON schemas and validators. It has
no runtime dependencies and contains no format logic.

| Entry                         | What it holds                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `@wolfsdk/protocol/contract`  | The engine contract: addresses, ops (`set`, `replace_text`, `insert`, `delete`, `move`), results. |
| `@wolfsdk/protocol/reactor`   | The stateful engine client: layout, pages and display lists.                                       |
| `@wolfsdk/protocol/session`   | The review session record (`wolfsdk.review-session.v1`) and its validators.                        |
| `@wolfsdk/protocol/workspace` | Rooms (`wolfsdk.room.v1`), the engine pipe (`wolfsdk.reactor-pipe.v1`), the MCP tools              |
|                               | (`wolfsdk.mcp-workspace.v1`) and packs (`wolfsdk.pack.v1`).                                        |
| `@wolfsdk/protocol/schemas/*` | The JSON schemas themselves, for validators in other languages.                                    |
| `@wolfsdk/protocol`           | Everything above.                                                                                  |

It ships TypeScript source and runs on [Bun](https://bun.sh) 1.4 or later.

```sh
bun add @wolfsdk/protocol
```

```ts
import { validateRoomEvent, validatePackManifest } from "@wolfsdk/protocol/workspace";
import roomSchema from "@wolfsdk/protocol/schemas/room.v1.schema.json" with { type: "json" };

const problems = validateRoomEvent(JSON.parse(frame)); // [] when the event is valid
```

A validator returns the list of what is wrong with a value and never throws.

## Licence

MIT.
