import { formatName } from '../utils/format';

const users = [{ id: '1', first: 'Ada', last: 'Lovelace' }];

export function listUsers() {
  return users.map(u => ({ id: u.id, name: formatName(u.first, u.last) }));
}

export function getUser(id: string) {
  return users.find(u => u.id === id) || null;
}
