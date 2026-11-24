/**
 * THE wording file: the words people see for common actions, statuses and
 * messages. Change a word here and it changes everywhere. Rules ("Wording and
 * tone" in CLAUDE.md): professional but plain, Title Case for page titles and
 * buttons, sentence case for descriptions, no jargon, slang, exclamation
 * marks or emojis, and never the word "tick".
 * Every word goes through tr(), so it shows in the person's language.
 */
import { tr } from '../i18n'

/** Buttons and links for common actions (Title Case). */
export const ACTION = {
  get save() {
    return tr('Save Changes')
  },
  get saving() {
    return tr('Saving…')
  },
  get cancel() {
    return tr('Cancel')
  },
  get confirm() {
    return tr('Confirm')
  },
  get close() {
    return tr('Close')
  },
  get done() {
    return tr('Done')
  },
  get create() {
    return tr('Create')
  },
  get add() {
    return tr('Add')
  },
  get edit() {
    return tr('Edit')
  },
  get archive() {
    return tr('Archive')
  },
  get restore() {
    return tr('Restore')
  },
  get permanentlyDelete() {
    return tr('Permanently Delete')
  },
  get deleting() {
    return tr('Deleting…')
  },
  get remove() {
    return tr('Remove')
  },
  get showArchived() {
    return tr('Show archived')
  },
  get select() {
    return tr('Select')
  },
  get selectAll() {
    return tr('Select All')
  },
  get clearSelection() {
    return tr('Clear Selection')
  },
  get markComplete() {
    return tr('Mark Complete')
  },
  get markIncomplete() {
    return tr('Mark Incomplete')
  },
  get notApplicable() {
    return tr('Not Applicable')
  },
  get markBuilt() {
    return tr('Mark as Built')
  },
  get markCrated() {
    return tr('Mark as Crated')
  },
  get start() {
    return tr('Start')
  },
  get finish() {
    return tr('Finish')
  },
  get pause() {
    return tr('Pause')
  },
  get resume() {
    return tr('Resume')
  },
  get undo() {
    return tr('Undo')
  },
  get allow() {
    return tr('Allow')
  },
  get grantAccess() {
    return tr('Grant Access')
  },
  get revokeAccess() {
    return tr('Revoke Access')
  },
  get enable() {
    return tr('Enable')
  },
  get disable() {
    return tr('Disable')
  },
  get print() {
    return tr('Print')
  },
  get copy() {
    return tr('Copy')
  },
  get copied() {
    return tr('Copied')
  },
  get signOut() {
    return tr('Sign Out')
  },
} as const

/** Status words (shown on badges, chips and lists). */
export const STATUS = {
  get completed() {
    return tr('Completed')
  },
  get incomplete() {
    return tr('Incomplete')
  },
  get notApplicable() {
    return tr('Not Applicable')
  },
  get built() {
    return tr('Built')
  },
  get notBuilt() {
    return tr('Not built')
  },
  get crated() {
    return tr('Crated')
  },
  get notCrated() {
    return tr('Not crated')
  },
  get finalCheckComplete() {
    return tr('Final check complete')
  },
  get allowed() {
    return tr('Allowed')
  },
  get notPermitted() {
    return tr('Not permitted')
  },
  get enabled() {
    return tr('Enabled')
  },
  get disabled() {
    return tr('Disabled')
  },
  get selected() {
    return tr('Selected')
  },
  get archived() {
    return tr('Archived')
  },
  get started() {
    return tr('Started')
  },
  get finished() {
    return tr('Finished')
  },
  get overdue() {
    return tr('Overdue')
  },
} as const

/** Standard messages: calm, specific, and saying what to do next. */
export const MESSAGE = {
  get genericError() {
    return tr('The request could not be completed. Check your internet connection and try again. If the problem continues, contact the office.')
  },
  get noPermission() {
    return tr('You do not have permission for this action. Contact an administrator if you need access.')
  },
  get offline() {
    return tr('The database could not be reached. Check your internet connection and try again.')
  },
  get duplicate() {
    return tr('This value is already in use. Enter a different value.')
  },
  get loading() {
    return tr('Loading…')
  },
  get comingLater() {
    return tr('This feature will be available in a future update.')
  },
  get noAccessTitle() {
    return tr('No Access')
  },
  get noAccessEmail() {
    return tr('This email doesn’t have access. Contact the office.')
  },
  get noAlerts() {
    return tr('There are no alerts at this time.')
  },
  get noNotifications() {
    return tr('You have no notifications.')
  },
  get noPaymentsOutstanding() {
    return tr('No payments are outstanding.')
  },
} as const

/** Builds a "Permanently delete X?" style question for the confirm box. */
export const confirmText = {
  archive: (what: string) => tr('Archive {{what}}? It can be restored later from the archive.', { what }),
  permanentlyDelete: (what: string) => tr('Permanently delete {{what}}? This cannot be undone.', { what }),
}
