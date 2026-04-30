import { Router } from 'express';
import { Types } from 'mongoose';
import { InstructionUpsertRequest } from '@rose/shared';
import { userIdOf } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { Instruction } from '@rose/db';
import { extractVariables } from '@rose/llm';

export const instructionsRouter: Router = Router();

instructionsRouter.get('/', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const scope = req.query.scope as string | undefined;
  const filter: Record<string, unknown> = { userId };
  if (scope) filter.scope = scope;
  const instructions = await Instruction.find(filter).sort({ scope: 1, name: 1 }).lean();
  res.json({ instructions });
});

instructionsRouter.post('/', validateBody(InstructionUpsertRequest), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const body = req.body as typeof InstructionUpsertRequest._type;
  const variables = body.variables ?? extractVariables(body.template);
  if (body.isDefault) {
    await Instruction.updateMany({ userId, scope: body.scope, isDefault: true }, { isDefault: false });
  }
  const created = await Instruction.create({
    userId,
    name: body.name,
    scope: body.scope,
    description: body.description ?? '',
    template: body.template,
    variables,
    isSystem: false,
    isDefault: !!body.isDefault,
  });
  res.status(201).json(created);
});

instructionsRouter.patch('/:id', validateBody(InstructionUpsertRequest.partial()), async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const inst = await Instruction.findOne({ _id: req.params.id, userId });
  if (!inst) {
    res.status(404).json({ error: 'not_found', message: 'Instruction not found' });
    return;
  }
  if (inst.isSystem) {
    res.status(400).json({
      error: 'invalid_request',
      message: 'System instructions are read-only. Clone one to customize it.',
    });
    return;
  }
  const body = req.body as Partial<typeof InstructionUpsertRequest._type>;
  if (body.name) inst.name = body.name;
  if (body.scope) inst.scope = body.scope;
  if (body.description !== undefined) inst.description = body.description;
  if (body.template) {
    inst.template = body.template;
    inst.variables = body.variables ?? extractVariables(body.template);
  }
  if (body.isDefault !== undefined) {
    if (body.isDefault) {
      await Instruction.updateMany(
        { userId, scope: inst.scope, isDefault: true, _id: { $ne: inst._id } },
        { isDefault: false },
      );
    }
    inst.isDefault = body.isDefault;
  }
  await inst.save();
  res.json(inst);
});

instructionsRouter.post('/:id/clone', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const src = await Instruction.findOne({ _id: req.params.id, userId });
  if (!src) {
    res.status(404).json({ error: 'not_found', message: 'Instruction not found' });
    return;
  }
  const created = await Instruction.create({
    userId,
    name: `${src.name} (custom)`,
    scope: src.scope,
    description: src.description,
    template: src.template,
    variables: src.variables,
    isSystem: false,
    isDefault: false,
  });
  res.status(201).json(created);
});

instructionsRouter.delete('/:id', async (req, res) => {
  const userId = new Types.ObjectId(userIdOf(req));
  const inst = await Instruction.findOne({ _id: req.params.id, userId });
  if (!inst) {
    res.json({ ok: true });
    return;
  }
  if (inst.isSystem) {
    res.status(400).json({ error: 'invalid_request', message: 'Cannot delete system instructions' });
    return;
  }
  await inst.deleteOne();
  res.json({ ok: true });
});
