"""add search_query and created_at index to events

Revision ID: a1b2c3d4e5f6
Revises: e9d2e36472ae
Create Date: 2026-05-17 03:00:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, None] = 'e9d2e36472ae'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'events',
        sa.Column('search_query', sa.String(), nullable=True),
    )
    op.create_index(
        op.f('ix_events_search_query'), 'events', ['search_query'], unique=False
    )
    op.create_index(
        op.f('ix_events_created_at'), 'events', ['created_at'], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f('ix_events_created_at'), table_name='events')
    op.drop_index(op.f('ix_events_search_query'), table_name='events')
    op.drop_column('events', 'search_query')
