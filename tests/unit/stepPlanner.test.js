const { normaliseSteps, stepDesignGuide, allowedTypes } = require('../../services/stepPlanner');

describe('stepPlanner', () => {
  test('keeps the AI-chosen count and kinds, drops unknown and duplicate types', () => {
    const steps = normaliseSteps([
      { type: 'reading_comprehension', label: 'Read the poem', instructions: 'Read and answer.' },
      { type: 'made_up_type', label: 'x', instructions: 'y' },
      { type: 'reading_comprehension', label: 'dup', instructions: 'dup' },
      { type: 'problem_solving', label: 'Solve', instructions: 'Solve these.', problems: ['2+2', '3x4'] },
      { type: 'writing_reflection', label: 'Reflect', instructions: 'Reflect.', reflectionPrompts: ['Why?'] },
    ], { subject: 'English' });
    expect(steps.map(s => s.type)).toEqual(['reading_comprehension', 'problem_solving', 'writing_reflection']);
    expect(steps[0].sections.length).toBeGreaterThan(0); // section defaults filled
    expect(steps[1].problems).toEqual(['2+2', '3x4']);
  });

  test('language learning never gets drawing', () => {
    expect(allowedTypes('Language Acquisition')).not.toContain('drawing');
    const steps = normaliseSteps([
      { type: 'drawing', label: 'Draw', instructions: 'Draw a tree.' },
      { type: 'language_practice', label: 'Practise', instructions: 'Write sentences.' },
    ], { subject: 'Language Acquisition' });
    expect(steps.map(s => s.type)).toEqual(['language_practice']);
    expect(stepDesignGuide({ topic: 'Nature', subject: 'Language Acquisition', grade: 'Grade 4', curriculum: 'CBSE', language: 'Hindi' }))
      .toMatch(/WRITE the target language/);
  });

  test('caps at 5 steps and fills missing problems', () => {
    const many = ['brainstorm', 'prior_knowledge', 'tuning_in', 'problem_solving', 'structured_writing', 'research_notes']
      .map(type => ({ type, label: type, instructions: 'do it' }));
    const steps = normaliseSteps(many, { subject: 'Mathematics', fallbackProblems: () => ['1+1'] });
    expect(steps).toHaveLength(5);
    expect(steps.find(s => s.type === 'problem_solving').problems).toEqual(['1+1']);
  });
});

describe('repairStepGaps', () => {
  const { repairStepGaps, findStepGaps } = require('../../services/stepPlanner');
  const opts = { subject: 'Language Acquisition' };
  const reflect = { type: 'writing_reflection', label: 'Reflect', instructions: 'Answer in Telugu.', reflectionPrompts: ['మీరు ఏమి నేర్చుకున్నారు?', 'ఏది కష్టంగా ఉంది?'] };
  const incomplete = normaliseSteps([{ type: 'language_practice', label: 'Vocab', instructions: 'Study the listed Telugu words and write a sentence for each.', sections: ['Words', 'Sentences'] }, reflect], opts);

  test('flags a single-step assignment and wrong-script text', () => {
    const one = normaliseSteps([reflect], opts);
    expect(findStepGaps(one).join(' ')).toMatch(/only 1 step/);
    const mixed = normaliseSteps([{ ...reflect, reflectionPrompts: ['తెలుగు是一种古老的语言?', 'ఏది?'] }, { ...reflect, type: 'communication' }], opts);
    expect(findStepGaps(mixed, { language: 'Telugu' }).join(' ')).toMatch(/han script/);
    expect(findStepGaps(normaliseSteps([reflect, { ...reflect, type: 'communication' }], opts), { language: 'Telugu' })).toEqual([]);
  });

  test('flags a language step with no word list', () => {
    expect(findStepGaps(incomplete).join(' ')).toMatch(/wordBank/);
  });

  test('asks the model to fill the gap and keeps the fixed steps', async () => {
    const complete = jest.fn().mockResolvedValue(JSON.stringify({ taskSteps: [{ ...incomplete[0],
      wordBank: ['చెట్టు (chettu) – tree', 'నది (nadi) – river', 'పక్షి (pakshi) – bird', 'పువ్వు (puvvu) – flower'] }, reflect] }));
    const { steps, gaps } = await repairStepGaps(incomplete, { complete, normaliseOpts: opts });
    expect(complete.mock.calls[0][0]).toMatch(/wordBank/);
    expect(steps[0].wordBank).toHaveLength(4);
    expect(gaps).toEqual([]);
  });

  test('keeps the original when the repair is no better or fails', async () => {
    const { steps } = await repairStepGaps(incomplete, { complete: jest.fn().mockRejectedValue(new Error('429')), normaliseOpts: opts });
    expect(steps).toBe(incomplete);
  });
});
