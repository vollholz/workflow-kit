/**
 * Rechte, die der Baukasten über `host.can` abfragt (Konzept Abschnitt 9). Die App baut sie in ihr Rechtemodell ein
 * (Fragment, W9) und ordnet sie Rollen und Bereichen zu. Das Paket kennt nur die Namen; Bezeichnung und Beschreibung
 * sind Vorschläge für die Oberfläche der App.
 */

export interface WorkflowPermission {
  name: string;
  label: string;
  description: string;
}

export const workflowPermissions = [
  { name: 'workflow:read', label: 'Workflows sehen', description: 'Workflows, Versionen und Läufe im Bereich sehen.' },
  { name: 'workflow:manage', label: 'Workflows bearbeiten', description: 'Entwürfe anlegen und ändern, Probelauf starten.' },
  {
    name: 'workflow:activate', label: 'Workflows aktivieren',
    description: 'Aktivieren, pausieren und archivieren; wird Akteur oder wählt einen Maschinen-Client, den die Person verwalten darf.',
  },
  { name: 'workflow:run', label: 'Workflows von Hand starten', description: 'Manuelle Auslöser starten.' },
  { name: 'workflow:operate', label: 'Vorfälle bearbeiten', description: 'Bei Vorfällen nochmals versuchen, Schritt überspringen oder abbrechen.' },
  { name: 'workflow:admin', label: 'Workflows einrichten', description: 'Workflows für den Mandanten einschalten und Limits festlegen.' },
  { name: 'task:work', label: 'Aufgaben erledigen', description: 'Eigene und Team-Aufgaben nehmen, erledigen und zurückgeben.' },
  { name: 'task:assign', label: 'Aufgaben zuweisen', description: 'Aufgaben anderen zuweisen, Massenaktionen ausführen.' },
  { name: 'queue:manage', label: 'Warteschlangen verwalten', description: 'Warteschlangen, Fristen (SLA) und Kalender verwalten.' },
  { name: 'case:create', label: 'Fälle anlegen', description: 'Fälle anlegen, auch ohne Vorlage.' },
  { name: 'case:read', label: 'Fälle sehen', description: 'Fälle lesen, an denen die Person nicht beteiligt ist.' },
] as const satisfies readonly WorkflowPermission[];

export type WorkflowPermissionName = (typeof workflowPermissions)[number]['name'];
