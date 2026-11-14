// Made-up minigame rounds for the Test Minigame Terminal command.
import type { MinigameForm } from './discordBrowser';

export interface TestRound {
  form: MinigameForm;
  answer: string;
}

export const TEST_ROUNDS: TestRound[] = [
  {
    form: {
      title: 'Fine',
      prompt:
        "Count the amount of E's in this text\n\nThe quick brown fox jumps over the lazy dog. She sells sea shells by the sea shore.",
      kind: 'text',
      maxLength: 2,
      timeLimitMs: 45_000,
    },
    answer: '10',
  },
  {
    form: {
      title: 'Brave',
      prompt: 'Find the number whose digits only ascend',
      kind: 'choice',
      options: [
        '918273', '123789', '554321', '987123', '135792', '246813', '112358', '975310', '864209',
        '192837', '273645', '384756', '495867', '516273', '627384', '738495', '849516', '951627',
        '162738', '273849', '384951', '495162', '516384', '627495', '738516',
      ],
      timeLimitMs: 45_000,
    },
    answer: '123789',
  },
  {
    form: {
      title: 'Corrupt',
      prompt: 'How many 1s are in this binary number?\n\n10110010111000101101001110100101100111010010110100',
      kind: 'text',
      maxLength: 2,
      timeLimitMs: 45_000,
    },
    answer: '26',
  },
  {
    form: {
      title: 'Real',
      prompt: 'Which planet in our solar system has the most confirmed moons as of the latest count?',
      kind: 'choice',
      options: ['Saturn', 'Jupiter', 'Uranus, the ice giant tipped on its side', 'Neptune'],
      timeLimitMs: 45_000,
    },
    answer: 'Saturn',
  },
];

/** Cat Bot's result text for a test answer. */
export function testResultText(round: TestRound, answer: string): { win: boolean; text: string } {
  const win = answer.trim().toLowerCase() === round.answer.toLowerCase();
  return {
    win,
    text: win
      ? `@you got +3 ${round.form.title} bonus cats. (test)`
      : `Better luck next time!\nCorrect answer: ${round.answer}\nYour answer: ${answer}`,
  };
}
