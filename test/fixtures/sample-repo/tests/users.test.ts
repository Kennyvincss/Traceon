import { listUsers, getUser } from '../src/services/userService';

describe('userService', () => {
  it('lists users', () => {
    expect(listUsers()).toHaveLength(1);
  });
  it('gets a user', () => {
    expect(getUser('1')).not.toBeNull();
  });
});
