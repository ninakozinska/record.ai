// Work, Family and School: "worlds" over the same notes. Each group belongs to
// one, guessed from its name (no AI needed), and the person can move it.
// Groups that fit none (Ideas, Inbox) show in all of them. School has one
// group per child ("School · Leo"), made when the person adds a child.
export const WORLDS = ['work', 'family', 'school'];
export const SCHOOL_PREFIX = 'School · ';
const SCHOOL = /\b(schools?|homework|teachers?|classroom|class trip|school trip|exams?|pta|after-?school|daycare|nursery|kindergarten|preschool|tutoring|tutor|uniforms?|semester|report cards?|parent-teacher)\b/i;

const WORK = /\b(work|office|job|meetings?|projects?|clients?|customers?|team|career|business|sales|marketing|boss|colleagues?|deadlines?|invoices?|conference|hiring|interviews?|reports?|admin)\b/i;
const FAMILY = /\b(home|house|household|family|kids?|children|child|baby|groceries|grocery|shopping|chores|cleaning|garden|pets?|dog|cat|health|doctor|dentist|medical|partner|husband|wife|birthdays?|holidays?|vacation|travel|recipes?|cooking|meals?|dinner|car|finance|bills|budget|personal|friends|sports?|activities|social|leisure|entertainment|music|concerts?|theat(?:er|re)|cinema|movies?|parties|party|culture|hobbies)\b/i;

/** 'work', 'family', 'school' or null (all), from the group's name. */
export function guessWorld(group) {
  const g = String(group || '');
  if (g.startsWith(SCHOOL_PREFIX) || SCHOOL.test(g)) return 'school';
  const work = WORK.test(g);
  const family = FAMILY.test(g);
  if (work && !family) return 'work';
  if (family && !work) return 'family';
  return null;
}

/** The person's choice for this group if they made one, else the guess. */
export function worldOf(group, chosen = {}) {
  const key = String(group || '').toLowerCase();
  if (Object.hasOwn(chosen, key)) return chosen[key] || null;
  return guessWorld(group);
}

/** Does a note in this group show in this world ('all' shows everything)? */
export const inWorld = (group, world, chosen = {}) => world === 'all' || !world || (worldOf(group, chosen) ?? world) === world;
