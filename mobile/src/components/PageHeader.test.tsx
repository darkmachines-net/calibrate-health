/** @file Regression coverage for Page Header: PageHeader. */

import { render } from '@testing-library/react-native';
import { PageHeader } from './PageHeader';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

describe('PageHeader', () => {
    it('marks the page title as the route-change focus target', async () => {
        const screen = await render(<PageHeader title="Example page" />);

        expect(screen.getByText('Example page').props.nativeID).toBe('route-focus-title');
    });
});
