import { Asset } from './Asset.js';
/**
 * People you hire. Tend to be cheaper than buildings and contribute to the
 * company head-count statistic. Otherwise behaves like any income asset.
 */
export class Employee extends Asset {
    constructor(config, world) {
        super(config, world);
        this.type = 'employee';
        this.icon = config.icon ?? '👤';
    }
}
//# sourceMappingURL=Employee.js.map