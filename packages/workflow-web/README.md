# @vollholz/workflow-web

Oberfläche zu `@vollholz/workflow` (React 19). Stand **Stufe 0**: Provider und Bausteine stehen fest, die Bausteine
zeigen vorerst «noch nicht verfügbar».

```tsx
import { WorkflowProvider, MyWork, SubjectWorkflowBar } from '@vollholz/workflow-web';
import '@vollholz/workflow-web/styles.css';

<WorkflowProvider api={{ baseUrl: '/v1', headers: () => ({ 'X-CSRF-Token': csrf }) }} me={me} can={can}
  subjects={{ order: { label: 'Bestellung', href: id => `/orders/${id}` } }}>
  <MyWork />
  <SubjectWorkflowBar subject={{ type: 'order', id }} />
</WorkflowProvider>
```

Exporte: `WorkflowProvider`, `useWorkflow`, `StepListEditor`, `MyWork`, `QueueView`, `CaseView`, `RunLog`,
`SubjectWorkflowBar` und deren Typen. Spricht mit dem Backend nur über HTTP; keine Abhängigkeit auf eine App.

Lizenz: Apache-2.0.
