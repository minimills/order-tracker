// @permission-scope automations
import { Modal, secondaryButtonClass } from '../form'
import RunLog from './RunLog'
import { ACTION } from '../../lib/wording'
import { tr } from '../../i18n'

/** The run log of one automation in a pop-up box (from the list). */
export default function RunLogDialog({ automation, onClose }: { automation: { id: string; name: string }; onClose: () => void }) {
  return (
    <Modal
      title={tr("Run Log: {{name}}", { name: automation.name })}
      wide
      onClose={onClose}
      footer={
        <button type="button" className={secondaryButtonClass} onClick={onClose}>
          {ACTION.close}
        </button>
      }
    >
      <RunLog automationId={automation.id} />
    </Modal>
  )
}
