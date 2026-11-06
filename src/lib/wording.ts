/**
 * THE wording file: the words people see for common actions, statuses and
 * messages. Change a word here and it changes everywhere. Rules ("Wording and
 * tone" in CLAUDE.md): professional but plain, Title Case for page titles and
 * buttons, sentence case for descriptions, no jargon, slang, exclamation
 * marks or emojis, and never the word "tick".
 */

/** Buttons and links for common actions (Title Case). */
export const ACTION = {
  save: 'Save Changes',
  saving: 'Saving…',
  cancel: 'Cancel',
  confirm: 'Confirm',
  close: 'Close',
  done: 'Done',
  create: 'Create',
  add: 'Add',
  edit: 'Edit',
  archive: 'Archive',
  restore: 'Restore',
  permanentlyDelete: 'Permanently Delete',
  deleting: 'Deleting…',
  remove: 'Remove',
  showArchived: 'Show archived',
  select: 'Select',
  selectAll: 'Select All',
  clearSelection: 'Clear Selection',
  markComplete: 'Mark Complete',
  markIncomplete: 'Mark Incomplete',
  notApplicable: 'Not Applicable',
  markBuilt: 'Mark as Built',
  markCrated: 'Mark as Crated',
  start: 'Start',
  finish: 'Finish',
  allow: 'Allow',
  grantAccess: 'Grant Access',
  revokeAccess: 'Revoke Access',
  enable: 'Enable',
  disable: 'Disable',
  print: 'Print',
  copy: 'Copy',
  copied: 'Copied',
  signOut: 'Sign Out',
} as const

/** Status words (shown on badges, chips and lists). */
export const STATUS = {
  completed: 'Completed',
  incomplete: 'Incomplete',
  notApplicable: 'Not Applicable',
  built: 'Built',
  notBuilt: 'Not built',
  crated: 'Crated',
  notCrated: 'Not crated',
  finalCheckComplete: 'Final check complete',
  allowed: 'Allowed',
  notPermitted: 'Not permitted',
  enabled: 'Enabled',
  disabled: 'Disabled',
  selected: 'Selected',
  archived: 'Archived',
  started: 'Started',
  finished: 'Finished',
  overdue: 'Overdue',
} as const

/** Standard messages: calm, specific, and saying what to do next. */
export const MESSAGE = {
  genericError: 'The request could not be completed. Check your internet connection and try again. If the problem continues, contact the office.',
  noPermission: 'You do not have permission for this action. Contact an administrator if you need access.',
  offline: 'The database could not be reached. Check your internet connection and try again.',
  duplicate: 'This value is already in use. Enter a different value.',
  loading: 'Loading…',
  comingLater: 'This feature will be available in a future update.',
  noAccessTitle: 'No Access',
  noAccessEmail: 'This email doesn’t have access. Contact the office.',
  noAlerts: 'There are no alerts at this time.',
  noNotifications: 'You have no notifications.',
  noPaymentsOutstanding: 'No payments are outstanding.',
} as const

/** Builds a "Permanently delete X?" style question for the confirm box. */
export const confirmText = {
  archive: (what: string) => `Archive ${what}? It can be restored later from the archive.`,
  permanentlyDelete: (what: string) => `Permanently delete ${what}? This cannot be undone.`,
}
