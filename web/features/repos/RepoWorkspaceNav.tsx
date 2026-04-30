import type { ReactNode } from 'react';
import { WorkspaceTabs } from './WorkspaceTabs';

type WorkspaceTabKey = 'chat' | 'files' | 'issues';

interface RepoWorkspaceNavProps {
  activeTab: WorkspaceTabKey;
  onBack: () => void;
  backTestId: string;
  backAriaLabel?: string;
  title: ReactNode;
  titleTestId?: string;
  rightSlot?: ReactNode;
}

export function RepoWorkspaceNav({
  activeTab,
  onBack,
  backTestId,
  backAriaLabel = '前の画面へ戻る',
  title,
  titleTestId,
  rightSlot
}: RepoWorkspaceNavProps) {
  return (
    <div className="fx-repo-nav">
      <div className="fx-repo-nav-head">
        <div className="fx-repo-nav-side">
          <button
            className="fx-back-icon"
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={onBack}
            data-testid={backTestId}
            aria-label={backAriaLabel}
          >
            ←
          </button>
        </div>
        <div className="fx-repo-nav-title" data-testid={titleTestId}>
          {title}
        </div>
        <div className="fx-repo-nav-side is-right">{rightSlot}</div>
      </div>
      <WorkspaceTabs active={activeTab} />
    </div>
  );
}
