import { join, resolve } from 'node:path';
import { homeDir } from '../config.mjs';
import { usageError } from '../errors.mjs';
import { table, tildePath } from '../format.mjs';
import { installSkills, listSkills } from '../skills.mjs';
import { vendorInfo } from '../vendor.mjs';

export function skillTarget(ctx, { project, path } = ctx.flags) {
  if (project && path) throw usageError('Gebruik --project of --path, niet allebei.');
  if (path) return resolve(ctx.cwd, path);
  if (project) return join(ctx.cwd, '.claude', 'skills');
  return join(homeDir(ctx.env), '.claude', 'skills');
}

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export const skillGroups = [{ path: ['skill'], summary: 'AI-skills uit de Mini Engine SDK installeren (Claude Code)' }];

export const skillCommands = [
  {
    path: ['skill', 'list'],
    usage: 'skill list',
    summary: 'Meegeleverde AI-skills',
    async run() {
      const skills = await listSkills();
      const sdk = vendorInfo()?.version ?? null;
      return {
        data: { sdk_version: sdk, skills },
        text: `${table(['NAAM', 'OMSCHRIJVING'], skills.map(skill => [skill.name, shorten(skill.description, 90)]))}\n\nUit SDK ${sdk ?? 'onbekend'}. Installeren: me skill install`,
      };
    },
  },
  {
    path: ['skill', 'install'],
    usage: 'skill install [naam…] [--project | --path MAP] [--force]',
    summary: 'AI-skills installeren in ~/.claude/skills',
    description: 'Zonder naam worden alle skills geïnstalleerd. Een bestaande skill met andere inhoud wordt alleen met --force overschreven.',
    options: { project: { type: 'boolean' }, path: { type: 'string' }, force: { type: 'boolean' } },
    optionHelp: [
      ['--project', 'In ./.claude/skills van dit project'],
      ['--path MAP', 'In een andere map'],
      ['--force', 'Bestaande skills met andere inhoud overschrijven'],
    ],
    args: [0, 10],
    examples: ['me skill install', 'me skill install --project', 'me skill install build-mini-engine-game --force'],
    async run(ctx) {
      const target = skillTarget(ctx);
      const plan = await installSkills(target, ctx.args, { force: ctx.flags.force });
      return {
        data: { target, skills: plan.map(({ name, destination, status }) => ({ name, path: destination, status })) },
        text: [
          table(['SKILL', 'RESULTAAT'], plan.map(item => [item.name, item.status])),
          '',
          `Map: ${tildePath(target, homeDir(ctx.env))}`,
          'Start een nieuwe Claude Code-sessie om ze te gebruiken.',
        ].join('\n'),
      };
    },
  },
];
