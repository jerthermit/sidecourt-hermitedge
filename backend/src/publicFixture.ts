import type { PlayStyle, SkillLevel } from './models.js';

// Invented member records for isolated public boards, never a private client roster.
const names = [
  'Sarah Mitchell', 'James Wilson', 'Emma Nguyen', 'Daniel Patel',
  'Olivia Campbell', 'Michael Chen', 'Jessica Brown', 'Thomas Kelly',
  'Chloe Taylor', 'Matthew Singh', 'Rebecca Walsh', 'Andrew Martin',
  'Sophie Williams', 'David Nguyen', 'Emily Clarke', 'Benjamin Harris',
  'Charlotte Evans', 'Ryan O’Connor', 'Hannah Lee', 'Joshua White',
  'Lauren Thompson', 'Nathan Scott', 'Grace Murphy', 'Adam Walker',
  'Isabella Roberts', 'Christopher Tran', 'Kate Anderson', 'Luke Robinson',
  'Mia Lewis', 'Samuel Wright', 'Nicole Jackson', 'Liam Ahmed',
  'Amelia Davies', 'Alexander Cooper', 'Rachel Thomas', 'Jack Edwards',
  'Lucy Johnson', 'William Parker', 'Natalie Young', 'Oliver Hughes',
  'Priya Shah', 'Noah Bennett', 'Zoe Turner', 'Ethan Collins',
  'Claire Stewart', 'Harry Morgan', 'Ava Brooks', 'Patrick Sullivan',
  'Erin Fitzgerald', 'George King', 'Amy Ward', 'Oscar Wood',
  'Ruby Phillips', 'Aaron Lim', 'Leah Graham', 'Finn McKenzie',
  'Alice Russell', 'Peter Hall', 'Jasmine Kaur', 'Scott Allen',
  'Brooke Davidson', 'Anthony Russo', 'Helen Murray', 'Jacob Reid',
  'Gemma Marshall', 'Paul Mitchell', 'Tara Simpson', 'Nicholas Green',
  'Louise Fraser', 'Sean McDonald', 'Melissa Foster', 'Timothy Ross',
  'Ellie Chapman', 'Chris Wilson', 'Mei Tan', 'Cameron Bell',
  'Michelle Robinson', 'Robert Hayes', 'Fiona McCarthy', 'Mark Spencer',
  'Deborah Reid', 'Stephen Wong', 'Angela Wright', 'Richard Davies',
  'Sienna Moore', 'Cooper Jenkins', 'Matilda Ryan', 'Archie Khan',
  'Abigail Cook', 'Charlie Adams', 'Georgia Howard', 'Leo Shah',
  'Janet Walker', 'Kevin Bailey', 'Wendy Collins', 'Brian Armstrong',
] as const;

export const PUBLIC_COURT_COUNT = 12;
export const publicCourtNames = Array.from({ length: PUBLIC_COURT_COUNT }, (_, index) => `Court ${index + 1}`);

export const publicRoster = names.map((name, index) => {
  const band: SkillLevel = index >= 40 && index < 44 ? 'intermediate'
    : index % 12 === 11 ? 'unrated' : index % 8 < 2 ? 'beginner'
      : index % 8 < 6 ? 'intermediate' : 'advanced';
  const base = band === 'beginner' ? 2.2 : band === 'intermediate' ? 3.1 : 4.1;
  return {
    name, externalId: `member-${String(index + 1).padStart(3, '0')}`,
    skillLevel: band, skillRating: band === 'unrated' ? null : Number((base + (index % 5) / 10).toFixed(1)),
    playStyle: (['Balanced', 'Tactical', 'Defensive', 'Aggressive'] as PlayStyle[])[index % 4]!,
  };
});
