import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

// GraphView の dynamic import 失敗（ネットワーク断など）で Suspense が再 throw する例外を捕捉する
export class GraphViewErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="empty-note main-pane">
          グラフの読み込みに失敗しました。再読み込みしてください
        </div>
      );
    }
    return this.props.children;
  }
}
