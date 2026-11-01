import type { DesignerRuntime } from '../designer';
import type { Runtime } from '../runtime';
import type { Store } from '../store';
import type { TrainerRuntime } from '../trainer';

export interface ApiDeps {
  store: Store;
  runtime: Runtime;
  designer: DesignerRuntime;
  trainer: TrainerRuntime;
}
