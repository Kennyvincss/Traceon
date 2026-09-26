import { Router } from 'express';
import { charge } from '../services/billing';

export const billingRouter = Router();
billingRouter.post('/charge', async (req, res) => res.json(await charge(req.body.amount)));
