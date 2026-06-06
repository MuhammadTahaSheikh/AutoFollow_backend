export const ROLES = ['super_admin', 'admin', 'user'];

export const ROLE_LABELS = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  user: 'User',
};

export function canManageMembers(role) {
  return role === 'super_admin' || role === 'admin';
}

export function canInviteRole(inviterRole, targetRole) {
  if (inviterRole === 'super_admin') {
    return targetRole === 'admin' || targetRole === 'user';
  }
  if (inviterRole === 'admin') {
    return targetRole === 'user';
  }
  return false;
}

export function canChangeMemberRole(actorRole) {
  return actorRole === 'super_admin';
}

export function canRemoveMember(actorRole, actorId, targetId, targetRole) {
  if (actorId === targetId) return false;
  if (actorRole === 'super_admin') {
    return targetRole !== 'super_admin' || true; // checked separately for last super admin
  }
  return false;
}
