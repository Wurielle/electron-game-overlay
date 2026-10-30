//! Placement-preserving permutation of the registered window stack.

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InvalidWindowOrder;

pub(crate) fn reorder_windows<T>(
    windows: &mut [T],
    window_ids: &[u32],
    id: impl Fn(&T) -> u32,
) -> Result<bool, InvalidWindowOrder> {
    use std::collections::{HashMap, HashSet};

    if windows.len() != window_ids.len() {
        return Err(InvalidWindowOrder);
    }
    let ranks: HashMap<_, _> = window_ids
        .iter()
        .copied()
        .enumerate()
        .map(|(rank, id)| (id, rank))
        .collect();
    let registered: HashSet<_> = windows.iter().map(&id).collect();
    if ranks.len() != windows.len()
        || registered.len() != windows.len()
        || registered.iter().any(|id| !ranks.contains_key(id))
    {
        return Err(InvalidWindowOrder);
    }
    let changed = windows.iter().map(&id).ne(window_ids.iter().copied());
    if changed {
        windows.sort_unstable_by_key(|window| ranks[&id(window)]);
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn invalid_permutations_are_rejected_before_any_mutation() {
        for order in [vec![2, 2], vec![2], vec![2, 99], vec![2, 7, 99], vec![]] {
            let mut windows = vec![(7, -321), (2, 123)];
            let before = windows.clone();
            assert_eq!(
                reorder_windows(&mut windows, &order, |w| w.0),
                Err(InvalidWindowOrder),
                "{order:?}"
            );
            assert_eq!(windows, before);
        }
    }

    #[test]
    fn reorder_moves_whole_entries_without_changing_placement_or_pixels() {
        let pixels = Arc::new(vec![1, 2, 3, 4]);
        let mut windows = vec![
            (7, -321, 42, Arc::clone(&pixels)),
            (2, 123, 99, Arc::new(vec![5])),
        ];
        assert_eq!(reorder_windows(&mut windows, &[2, 7], |w| w.0), Ok(true));
        assert_eq!(windows.iter().map(|w| w.0).collect::<Vec<_>>(), [2, 7]);
        assert_eq!((windows[1].1, windows[1].2), (-321, 42));
        assert!(Arc::ptr_eq(&windows[1].3, &pixels));
    }
}
