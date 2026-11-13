/**
 * Select compiled installed-editor modules. Selection alone proves no execution.
 *
 * @param {readonly string[]} modules
 * @param {{
 *   focused?: string | undefined,
 *   racesOnly?: boolean | undefined,
 *   trustOnly?: boolean | undefined,
 *   compatibility?: boolean | undefined,
 *   endurance?: boolean | undefined,
 *   soak?: boolean | undefined,
 * }} [options]
 */
export function selectInstalledModules(
  modules,
  { focused, racesOnly, trustOnly, compatibility, endurance, soak } = {},
) {
  if (focused)
    return modules.filter((name) => focused.split(',').includes(name.replace(/\.case\.cjs$/u, '')));
  if (racesOnly)
    return modules.filter((name) => name.startsWith('race-') || name.startsWith('workspace-'));
  if (trustOnly) return modules.filter((name) => name.startsWith('trust-'));
  if (compatibility) return modules.filter((name) => name.startsWith('compat-'));
  if (endurance) return modules.filter((name) => /^endurance-(100|1000|saturation)\./u.test(name));
  if (soak) return modules.filter((name) => name.startsWith('endurance-soak.'));
  return modules.filter((name) => !/^(compat-|endurance-|remote-)/u.test(name));
}
