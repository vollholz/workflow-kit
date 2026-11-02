# @vollholz/workflow

App-agnostischer Workflow-Baukasten für Fastify-Apps: Ports, Definition von Workflows (JSON-Schema mit Prüfung),
Ausdrücke ohne Skripte und ein Plugin. Stand **Stufe 0** (Gerüst): Engine, Tabellen und Jobs folgen ab Stufe 1.

```ts
import { workflow } from '@vollholz/workflow';

const wf = workflow({ schema: 'app', host, subjects, actions, events, stateFields });
await app.register(wf.plugin);                 // GET /v1/workflows/status
await wf.dispatch(tx, event);                  // im Schreibpfad (Stufe 0: tut nichts)
await wf.checkTransition(tx, actor, subject, field, from, to);   // Stufe 0: immer erlaubt
wf.validate(definition);                       // { ok, errors: [{ path, message }] }
```

Exporte: `workflow`, `validateDefinition`, `definitionSchema`, `evaluateCondition`, `renderTemplate`,
`resolveValue`, `resolvePath`, `templateProblems`, `parseTemplate`, `workflowPermissions`, `WORKFLOW_EVENT_TYPES`,
`DEFAULT_LIMITS` und die Typen der Ports (`WorkflowHost`, `WorkflowSubject`, `WorkflowAction`, `StateField`,
`EventSource`, `FieldDef`, `FieldKind`, `Tx`, `Migration` …).

Abhängigkeiten: `ajv`; `fastify` ^5 als Peer. Keine Abhängigkeit auf eine App. Siehe README des Repos.

Lizenz: Apache-2.0.
