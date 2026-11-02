/** Provider und Platzhalter der Bausteine (Stufe 0). */
import { render, screen } from '@testing-library/react';
import { CaseView, MyWork, QueueView, RunLog, StepListEditor, SubjectWorkflowBar, useWorkflow, WorkflowProvider } from '../src/index.ts';

const api = { baseUrl: '/v1' };
const me = { id: 'p1', kind: 'person' as const };

function Probe() {
  const w = useWorkflow();
  return <p>{`${w.me?.id} ${w.can('task:work') ? 'darf' : 'darf nicht'} ${w.subjects.order?.label}`}</p>;
}

test('Bausteine zeigen «noch nicht verfügbar» im Provider', () => {
  render(
    <WorkflowProvider api={api} me={me} can={p => p === 'task:work'} subjects={{ order: { label: 'Bestellung' } }}>
      <Probe />
      <StepListEditor />
      <MyWork />
      <QueueView queueId="q1" />
      <CaseView caseId="c1" />
      <RunLog />
      <SubjectWorkflowBar subject={{ type: 'order', id: 'o1' }} />
    </WorkflowProvider>,
  );
  expect(screen.getByText('p1 darf Bestellung')).toBeInTheDocument();
  expect(screen.getAllByRole('status')).toHaveLength(6);
  expect(screen.getAllByText('noch nicht verfügbar')).toHaveLength(6);
  expect(screen.getByText('Meine Arbeit')).toBeInTheDocument();
});

test('ohne Provider: verständlicher Fehler', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => render(<MyWork />)).toThrow(/<WorkflowProvider>/);
  spy.mockRestore();
});
