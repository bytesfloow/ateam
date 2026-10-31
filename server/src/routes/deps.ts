import type { DesignerRuntime } from '../designer';
import type { Runtime } from '../runtime';
import type { Store } from '../store';

export interface ApiDeps {
  store: Store;
  runtime: Runtime;
  designer: DesignerRuntime;
}
