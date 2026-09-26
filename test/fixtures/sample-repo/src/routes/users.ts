import { Router } from 'express';
import { listUsers, getUser } from '../services/userService';

export const usersRouter = Router();
usersRouter.get('/', (_req, res) => res.json(listUsers()));
usersRouter.get('/:id', (req, res) => res.json(getUser(req.params.id)));
