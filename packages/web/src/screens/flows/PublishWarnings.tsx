/**
 * Notices the daemon attached to a successful publish (today: a Send Webhook node naming a
 * destination that is unknown or disabled). Deliberately not an alert and never part of
 * validation: the flow is published and runs, only that node's alert will not be sent.
 */
export const PublishWarnings = (props: { warnings: readonly string[] }): JSX.Element | null =>
  props.warnings.length === 0 ? null : (
    <div role="note" className="flow-page-notice publish-warnings">
      <strong>Published with warnings</strong>
      <ul>
        {props.warnings.map((warning) => (
          <li key={warning}>{warning}</li>
        ))}
      </ul>
    </div>
  );
